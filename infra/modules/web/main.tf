# Delivery of the console (M6, ADR 0046): a private S3 bucket that holds the build, a CloudFront
# distribution that reads it through an origin access control, a response headers policy that
# carries the strict CSP and the security headers, and a bucket for the S3 server access logs.
#
# The distribution uses the CloudFront default certificate, so there is no custom domain and the
# minimum protocol is TLSv1 (accepted risk R52). The CSP names the region-scoped API, WebSocket,
# Cognito and Kinesis Video hosts, so no CloudFront origin is needed by the API (ADR 0046).

locals {
  console_bucket_name = "${var.name_prefix}-console-${var.bucket_suffix}"
  logs_bucket_name    = "${var.name_prefix}-logs-${var.bucket_suffix}"
  console_bucket_arn  = "arn:aws:s3:::${local.console_bucket_name}"
  logs_bucket_arn     = "arn:aws:s3:::${local.logs_bucket_name}"

  # The site-maps bucket is owned by the site-maps module. Its name is derived here as well, from the
  # same inputs, so that the CSP can name its host without a module cycle (site-maps needs the console
  # origin from this module). The demo root checks that both names are equal (ADR 0054).
  site_maps_bucket_name = "${var.name_prefix}-site-maps-${var.bucket_suffix}"
  site_maps_bucket_arn  = "arn:aws:s3:::${local.site_maps_bucket_name}"

  # Server access logs of the buckets land under this prefix of the logs bucket: the console bucket
  # under s3/, the site-maps bucket under s3/site-maps/ (site-maps module).
  access_log_prefix = "s3/"

  # Managed policies of CloudFront, referenced by their public ids. They are the same in every
  # account and region, so they are not inputs.
  cache_policy_caching_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  cache_policy_caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"

  # The CSP names the regional hosts of the API, the WebSocket, Cognito and Kinesis Video. No
  # inline script or style and no eval are allowed: the build must not need them (SEC-WEB-1).
  content_security_policy = join("; ", [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' https://*.execute-api.${var.region}.amazonaws.com wss://*.execute-api.${var.region}.amazonaws.com https://cognito-idp.${var.region}.amazonaws.com https://cognito-identity.${var.region}.amazonaws.com https://kinesisvideo.${var.region}.amazonaws.com https://*.kinesisvideo.${var.region}.amazonaws.com wss://*.kinesisvideo.${var.region}.amazonaws.com https://${local.site_maps_bucket_name}.s3.${var.region}.amazonaws.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ])
}

# ---------------------------------------------------------------------------------------------
# Console bucket
# ---------------------------------------------------------------------------------------------

resource "aws_s3_bucket" "console" {
  #checkov:skip=CKV_AWS_21:No versioning: the bucket holds a build that publish-console replaces as a whole; a rollback is a rebuild of an earlier commit.
  #checkov:skip=CKV_AWS_144:No cross-region replication: multi-region HA is out of scope (SPEC section 11).
  #checkov:skip=CKV_AWS_145:AWS-managed AES256 keys instead of a customer-managed KMS key: SPEC section 11 excludes custom keys for cost.
  #checkov:skip=CKV2_AWS_62:No event notifications: nothing consumes the uploads of the console build.
  bucket = local.console_bucket_name

  # make destroy must remove the bucket with its objects. The deploy role may delete objects of
  # mfc-demo-* buckets (infra/bootstrap/policies.tf), and the build is reproducible from git.
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "console" {
  bucket = aws_s3_bucket.console.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "console" {
  bucket                  = aws_s3_bucket.console.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Trivy AWS-0132 wants SSE-KMS: AWS-managed keys, out of scope for cost (SPEC section 11).
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "console" {
  bucket = aws_s3_bucket.console.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "console" {
  bucket = aws_s3_bucket.console.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Only the distribution reads the build (OAC, SEC-WEB-1). The read statement names the distribution
# ARN, which AWS assigns at creation, so it is a separate document. The TLS denies do not depend on
# it, and they are merged into the same policy, so the bucket accepts only TLS 1.2 or later. The
# publish script writes with the operator's SSO session, which the bucket policy does not name.
data "aws_iam_policy_document" "console_read" {
  source_policy_documents = [data.aws_iam_policy_document.console_tls.json]

  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${local.console_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

data "aws_iam_policy_document" "console_tls" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.console_bucket_arn, "${local.console_bucket_arn}/*"]

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
    resources = [local.console_bucket_arn, "${local.console_bucket_arn}/*"]

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

resource "aws_s3_bucket_policy" "console" {
  bucket = aws_s3_bucket.console.id
  policy = data.aws_iam_policy_document.console_read.json
  # The TLS denies are merged into the read statement so that one policy governs the bucket.
  depends_on = [aws_s3_bucket_public_access_block.console]
}

# ---------------------------------------------------------------------------------------------
# Access logs bucket
# ---------------------------------------------------------------------------------------------

# Receives the S3 server access logs of the console bucket. CloudFront standard logging needs a
# us-east-1 delivery source and classic logging needs object ACLs, so neither is used (ADR 0046).
resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_18:A log bucket does not log itself: its own access is recorded by CloudTrail data events, which are off by decision (ADR 0022).
  #checkov:skip=CKV_AWS_21:No versioning: the logs are write-once and expire after 30 days.
  #checkov:skip=CKV_AWS_144:No cross-region replication: multi-region HA is out of scope (SPEC section 11).
  #checkov:skip=CKV_AWS_145:AWS-managed AES256 keys instead of a customer-managed KMS key: SPEC section 11 excludes custom keys for cost.
  #checkov:skip=CKV2_AWS_62:No event notifications: nothing consumes the access logs.
  bucket        = local.logs_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Trivy AWS-0132 wants SSE-KMS: AWS-managed keys, out of scope for cost (SPEC section 11).
#trivy:ignore:AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The logs are kept for 30 days (SPEC section 8), then expire.
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 30
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

# The S3 log delivery service writes only under its prefix, and only for the console and site-maps
# buckets of this account (confused deputy check on the source account and the source bucket).
data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "AllowBucketAccessLogs"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${local.logs_bucket_arn}/${local.access_log_prefix}*"]

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.console_bucket_arn, local.site_maps_bucket_arn]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.logs_bucket_arn, "${local.logs_bucket_arn}/*"]

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
    resources = [local.logs_bucket_arn, "${local.logs_bucket_arn}/*"]

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

resource "aws_s3_bucket_policy" "logs" {
  bucket     = aws_s3_bucket.logs.id
  policy     = data.aws_iam_policy_document.logs.json
  depends_on = [aws_s3_bucket_public_access_block.logs]
}

# Server access logging of the console bucket. The target policy must exist before logging is
# enabled, or S3 refuses the delivery.
resource "aws_s3_bucket_logging" "console" {
  bucket        = aws_s3_bucket.console.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = local.access_log_prefix
  depends_on    = [aws_s3_bucket_policy.logs]
}

# ---------------------------------------------------------------------------------------------
# CloudFront
# ---------------------------------------------------------------------------------------------

resource "aws_cloudfront_origin_access_control" "console" {
  name                              = "${var.name_prefix}-console"
  description                       = "Signs the requests of the console distribution to its private bucket."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# The security headers of every response of the console (SEC-WEB-1). frame-ancestors is in the CSP
# and X-Frame-Options is the fallback for old browsers. Permissions-Policy and the cross-origin
# headers are custom headers, because the managed fields do not offer them.
resource "aws_cloudfront_response_headers_policy" "console" {
  #checkov:skip=CKV_AWS_259:preload stays false: the preload list only takes hosts the owner submits, and the host is a cloudfront.net name that the demo does not own (ADR 0046).
  name    = "${var.name_prefix}-console-security-headers"
  comment = "Strict CSP and security headers of the console."

  security_headers_config {
    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }

    strict_transport_security {
      access_control_max_age_sec = 63072000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "no-referrer"
      override        = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=()"
      override = true
    }

    items {
      header   = "Cross-Origin-Opener-Policy"
      value    = "same-origin"
      override = true
    }

    items {
      header   = "Cross-Origin-Resource-Policy"
      value    = "same-origin"
      override = true
    }
  }
}

# Trivy AWS-0011 wants a WAF: none on purpose, for cost (SPEC section 11, THREAT_MODEL R1).
#trivy:ignore:AWS-0011
resource "aws_cloudfront_distribution" "this" {
  #checkov:skip=CKV_AWS_68:No WAF: SPEC section 11 and THREAT_MODEL R1 (cost; throttling and the API limits bound the abuse).
  #checkov:skip=CKV2_AWS_47:No WAF, so no Log4j managed rule (THREAT_MODEL R1).
  #checkov:skip=CKV_AWS_86:No CloudFront standard logging: classic logging needs object ACLs and standard logging needs a us-east-1 source (ADR 0046). The S3 access logs of the bucket record every origin fetch.
  #checkov:skip=CKV_AWS_174:CloudFront default certificate, which forces TLSv1 as the minimum protocol. Accepted risk R52 (ADR 0046): no custom domain exists to hold an ACM certificate.
  #checkov:skip=CKV2_AWS_42:CloudFront default certificate, no custom domain (ADR 0046, R52).
  #checkov:skip=CKV_AWS_310:Single origin: an origin group would add a second bucket with no benefit for the demo (ADR 0046).
  #checkov:skip=CKV_AWS_374:No geo restriction: the console is public for the demo operators and is protected by the Cognito sign-in (ADR 0046).
  comment             = "${var.name_prefix} console"
  enabled             = true
  is_ipv6_enabled     = true
  http_version        = "http2and3"
  price_class         = "PriceClass_100"
  default_root_object = "index.html"

  origin {
    domain_name              = aws_s3_bucket.console.bucket_regional_domain_name
    origin_id                = "console-bucket"
    origin_access_control_id = aws_cloudfront_origin_access_control.console.id
  }

  # index.html and config.json change on every publish, so they are never cached.
  default_cache_behavior {
    target_origin_id           = "console-bucket"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_policy_caching_disabled
    response_headers_policy_id = aws_cloudfront_response_headers_policy.console.id
  }

  # The build assets carry a content hash in their name, so they are cached for a long time.
  ordered_cache_behavior {
    path_pattern               = "/assets/*"
    target_origin_id           = "console-bucket"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_policy_caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.console.id
  }

  # The console is a single page application: an unknown path gets index.html, and the router
  # decides what to show. The error is not cached, so a fix is visible at once.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # The default certificate: no custom domain (ADR 0046, accepted risk R52).
  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
