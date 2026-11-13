# Multi-region management-events trail (ADR 0022) and its private bucket. The bucket name must
# keep the mfc-demo-trail- prefix: the deploy role may only read and tag mfc-demo-trail-* and the
# workload boundary denies it entirely (ADR 0024). Changing a setting of the bucket or the trail, or
# creating them after make destroy, is applied from the owner's SSO session (ADR 0022, ADR 0024).

locals {
  trail_name  = "${var.name_prefix}-trail"
  bucket_name = "${var.name_prefix}-trail-${var.bucket_suffix}"
  bucket_arn  = "arn:aws:s3:::${local.bucket_name}"
  # Built as a string: the bucket policy must name the trail before the trail exists.
  trail_arn = "arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${local.trail_name}"
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV_AWS_18:No server access log bucket: a second bucket and its cost for logs of a log bucket. CloudTrail management events record every change of this bucket.
  #checkov:skip=CKV2_AWS_62:No event notifications: nothing consumes log deliveries.
  #checkov:skip=CKV_AWS_145:AWS-managed AES256 keys instead of a customer-managed KMS key: SPEC section 11 excludes custom keys for cost.
  #checkov:skip=CKV_AWS_144:No cross-region replication: multi-region HA is out of scope (SPEC section 11).
  bucket = local.bucket_name

  # The deploy role may only read and tag this bucket (ADR 0024), so the flag only takes effect in
  # The owner's SSO session at make destroy; a CI destroy fails closed.
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration {
    status = "Enabled"
  }
}

# Trivy AWS-0132 wants SSE-KMS: AWS-managed keys, out of scope for cost (SPEC section 11).
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket     = aws_s3_bucket.this.id
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "expire-trail-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.log_retention_days
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_retention_days
    }
  }

  # Removes a delete marker once no other version remains. It cannot share an expiration block
  # with days, so it is a rule of its own.
  rule {
    id     = "expire-delete-markers"
    status = "Enabled"
    filter {}
    expiration {
      expired_object_delete_marker = true
    }
  }

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket     = aws_s3_bucket.this.id
  depends_on = [aws_s3_bucket_public_access_block.this]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = ["s3:GetBucketAcl"]
        Resource  = [local.bucket_arn]
        Condition = { StringEquals = { "aws:SourceArn" = local.trail_arn } }
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = ["s3:PutObject"]
        Resource  = ["${local.bucket_arn}/AWSLogs/${var.account_id}/*"]
        Condition = {
          StringEquals = {
            "s3:x-amz-acl"  = "bucket-owner-full-control"
            "aws:SourceArn" = local.trail_arn
          }
        }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:*"]
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
      {
        Sid       = "DenyOldTlsVersions"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:*"]
        Resource  = [local.bucket_arn, "${local.bucket_arn}/*"]
        Condition = { NumericLessThan = { "s3:TlsVersion" = 1.2 } }
      },
    ]
  })
}

# Trivy AWS-0015 wants a customer-managed KMS key: out of scope for cost (SPEC section 11).
#trivy:ignore:AWS-0015
resource "aws_cloudtrail" "this" {
  #checkov:skip=CKV_AWS_35:SSE-S3 instead of a customer-managed KMS key: SPEC section 11 excludes custom keys for cost.
  #checkov:skip=CKV_AWS_252:No SNS notification per log delivery: it would only produce noise.
  #checkov:skip=CKV2_AWS_10:No CloudWatch Logs delivery: ingestion is billed, and management events stay in the free 90-day event history.
  name           = local.trail_name
  s3_bucket_name = aws_s3_bucket.this.id

  # Multi-region: a single-region trail outside us-east-1 does not receive IAM and STS events (ADR 0022).
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = true

  # No event_selector, advanced_event_selector or insight_selector: the default records all
  # management events, and declaring selectors calls PutEventSelectors, which the deploy role is
  # denied. Creating the trail and any later change other than tags and StartLogging are denied to CI
  # (ADR 0020, ADR 0024): change the trail from the owner's SSO session and in code in the same PR.

  # CreateTrail checks the bucket policy, so it must exist first.
  depends_on = [aws_s3_bucket_policy.this]
}

# The bucket policy names the trail by trail_arn, which is built from the name because the policy
# must exist before the trail does. If AWS assigned another ARN, the policy would admit no delivery
# and CloudTrail would stop writing logs. A failed check is a plan warning, not an error; make smoke
# reports the resulting delivery error.
check "trail_arn_matches_policy" {
  assert {
    condition     = aws_cloudtrail.this.arn == local.trail_arn
    error_message = "the trail ARN built in locals must equal the ARN AWS assigns to the trail, because the bucket policy names the trail by the built ARN; a mismatch stops CloudTrail log delivery"
  }
}
