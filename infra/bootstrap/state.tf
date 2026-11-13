# Terraform state bucket for every root of the project. It is the most sensitive data store of
# the bootstrap: losing it loses the record of what exists, and tampering with it can make a
# later apply delete resources. Hence: versioned, private, TLS-only, never destroyed by Terraform.

locals {
  state_bucket_arn = "arn:aws:s3:::${var.state_bucket_name}"
}

resource "aws_s3_bucket" "state" {
  # Checkov and Trivy skips below: each is a deliberate choice for this demo, see the reasons.
  #checkov:skip=CKV_AWS_18:No server access log bucket: object reads are not logged, to avoid a second bucket and its cost. Management events of CloudTrail record every change of this bucket (SEC-LOG-1).
  #checkov:skip=CKV2_AWS_62:No event notifications: nothing consumes state writes, so there is no target for a notification.
  #checkov:skip=CKV_AWS_145:AWS-managed AES256 keys instead of a customer-managed KMS key: SPEC section 11 excludes custom keys for cost. The bucket is private and TLS-only.
  #checkov:skip=CKV_AWS_144:No cross-region replication: state is recoverable through object versions, and multi-region HA is out of scope (SPEC section 11).
  bucket = var.state_bucket_name

  # A destroy of this bucket would delete every state file. Terraform refuses it; removing the
  # guard is a deliberate, reviewed change.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  # Disables ACLs entirely, so access is only granted by IAM and the bucket policy below.
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  # Versioning is what makes a bad apply recoverable: the previous state can be restored.
  versioning_configuration {
    status = "Enabled"
  }
}

# Trivy AWS-0132 wants SSE-KMS. Same decision as the Checkov skip on the bucket: AWS-managed keys, out of scope for cost (SPEC section 11).
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # AWS-managed keys: a customer-managed KMS key is out of scope for cost (SPEC section 11).
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  # Versioning must be enabled before a noncurrent-version rule is accepted.
  depends_on = [aws_s3_bucket_versioning.state]

  # Ninety days keeps a long recovery window for old states without growing without bound.
  rule {
    id     = "expire-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }

  # Multipart uploads that never complete are billed as storage until they are aborted.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id

  # The public access block is applied first so that the policy is never evaluated against a
  # bucket that could still be made public.
  depends_on = [aws_s3_bucket_public_access_block.state]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Plain HTTP would send state, which contains resource attributes, in clear text.
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:*"]
        Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        Condition = {
          Bool = { "aws:SecureTransport" = "false" }
        }
      },
      {
        # TLS 1.0 and 1.1 are deprecated; the SPEC requires 1.2 at least (CHECKLIST V9).
        Sid       = "DenyOldTlsVersions"
        Effect    = "Deny"
        Principal = "*"
        Action    = ["s3:*"]
        Resource  = [local.state_bucket_arn, "${local.state_bucket_arn}/*"]
        Condition = {
          NumericLessThan = { "s3:TlsVersion" = 1.2 }
        }
      },
    ]
  })
}
