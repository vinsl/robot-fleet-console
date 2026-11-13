# Storage of the site maps (M7, SPEC section 4.5 and section 8): a private, versioned bucket that holds
# the GeoJSON files of the site. The browser uploads a file with a presigned POST that the site
# function signs, and the function reads every version back by its S3 version id, so a map is
# validated and activated exactly as it was checked (THREAT_MODEL T6).
#
# The bucket is data, not a build: its objects are versioned and logged, the non-current versions
# expire after 30 days, and the current versions stay until they are replaced or the stack is
# destroyed. The bucket policy only denies: the function role is the one grant (infra/envs/demo/site.tf).

locals {
  bucket_name = "${var.name_prefix}-site-maps-${var.bucket_suffix}"
  bucket_arn  = "arn:aws:s3:::${local.bucket_name}"

  # Server access logs of this bucket land under this prefix of the logs bucket, beside the logs of
  # the console bucket (web module, prefix s3/).
  access_log_prefix = "s3/site-maps/"
}

resource "aws_s3_bucket" "this" {
  #checkov:skip=CKV2_AWS_62:No event notifications: nothing consumes the uploads, the site function reads them on request.
  #checkov:skip=CKV_AWS_144:No cross-region replication: multi-region HA is out of scope (SPEC section 11).
  #checkov:skip=CKV_AWS_145:AWS-managed AES256 keys instead of a customer-managed KMS key: SPEC section 11 excludes custom keys for cost.
  bucket = local.bucket_name

  # make destroy must remove the bucket with its versions. The deploy role may delete objects of
  # mfc-demo-* buckets (infra/bootstrap/policies.tf), and the maps are data of the demo only.
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

# Every version of a map is kept: the activation points at one version id, and a validated version
# must still be readable after a newer upload.
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

# The current version of a map never expires: the version cap of 200 per site bounds the storage
# (SPEC section 9). The superseded versions and the uploads that were never finished do.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket     = aws_s3_bucket.this.id
  depends_on = [aws_s3_bucket_versioning.this]

  rule {
    id     = "expire-noncurrent-map-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The browser of the console is the only cross-origin client: the presigned POST of an upload and the
# GET of a preview. No credential is sent cross-origin, so the requests carry no cookie and no
# authorization header. The origin is the console origin, never a wildcard (ADR 0054).
resource "aws_s3_bucket_cors_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  cors_rule {
    allowed_origins = [var.console_origin]
    allowed_methods = ["GET", "POST"]
    allowed_headers = ["*"]
    max_age_seconds = 600
  }
}

# Refuses plain HTTP and TLS older than 1.2, as the console bucket does. The grants are in the
# function role, not in this policy.
data "aws_iam_policy_document" "tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyOldTlsVersions"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.bucket_arn, "${local.bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "NumericLessThan"
      variable = "s3:TlsVersion"
      values   = ["1.2"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket     = aws_s3_bucket.this.id
  policy     = data.aws_iam_policy_document.tls.json
  depends_on = [aws_s3_bucket_public_access_block.this]
}

# Server access logging. The target policy of the logs bucket names this bucket as a log source, and
# the policy is attached through the logs_bucket_name output of the web module, which is ordered
# after that policy: S3 refuses the delivery before it exists.
resource "aws_s3_bucket_logging" "this" {
  bucket        = aws_s3_bucket.this.id
  target_bucket = var.logs_bucket_name
  target_prefix = local.access_log_prefix
}
