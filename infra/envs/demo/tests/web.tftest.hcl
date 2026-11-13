# Executable checks of the web module (M6, ADR 0046): the console bucket stays private and reachable
# only by the distribution over TLS, the access logs land in the logs bucket only, the distribution
# serves the build over HTTPS with single-page routing and the default certificate, and the response
# headers policy carries the strict CSP, HSTS and the framing and cross-origin headers.
#
# The provider is configured without credentials and every skip flag is set, so the plan makes no
# AWS call. The policy documents are data sources built locally, so the TLS statements are readable
# in the plan. The CloudFront read statement names the distribution ARN, which only AWS assigns: it
# is reviewed in the plan comment of the deploy workflow (the R50 limit). The ARNs, ids and the domain
# name that AWS generates are fixed with override_resource.

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
  name_prefix   = "mfc-demo"
  bucket_suffix = "vinsl"
  account_id    = "123456789012"
  region        = "eu-west-3"
}

override_resource {
  target          = aws_cloudfront_distribution.this
  override_during = plan
  values = {
    id          = "E1ABCDEF2GHIJK"
    arn         = "arn:aws:cloudfront::123456789012:distribution/E1ABCDEF2GHIJK"
    domain_name = "d111111abcdef8.cloudfront.net"
  }
}

override_resource {
  target          = aws_cloudfront_response_headers_policy.console
  override_during = plan
  values          = { id = "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" }
}

override_resource {
  target          = aws_s3_bucket.console
  override_during = plan
  values = {
    id                          = "mfc-demo-console-vinsl"
    arn                         = "arn:aws:s3:::mfc-demo-console-vinsl"
    bucket_regional_domain_name = "mfc-demo-console-vinsl.s3.eu-west-3.amazonaws.com"
  }
}

override_resource {
  target          = aws_s3_bucket.logs
  override_during = plan
  values          = { id = "mfc-demo-logs-vinsl", arn = "arn:aws:s3:::mfc-demo-logs-vinsl" }
}

run "console_bucket_is_private_and_encrypted" {
  command = plan

  module {
    source = "../../modules/web"
  }

  assert {
    condition     = aws_s3_bucket.console.bucket == "mfc-demo-console-vinsl" && aws_s3_bucket.logs.bucket == "mfc-demo-logs-vinsl"
    error_message = "the buckets are named mfc-demo-console-<suffix> and mfc-demo-logs-<suffix>, so the deploy role's mfc-demo-* grant covers them"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.console.block_public_acls && aws_s3_bucket_public_access_block.console.block_public_policy && aws_s3_bucket_public_access_block.console.ignore_public_acls && aws_s3_bucket_public_access_block.console.restrict_public_buckets
    error_message = "the console bucket must block every public access (SEC-WEB-1)"
  }

  assert {
    condition     = aws_s3_bucket_public_access_block.logs.block_public_acls && aws_s3_bucket_public_access_block.logs.block_public_policy && aws_s3_bucket_public_access_block.logs.ignore_public_acls && aws_s3_bucket_public_access_block.logs.restrict_public_buckets
    error_message = "the logs bucket must block every public access"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_ownership_controls.console.rule : r.object_ownership == "BucketOwnerEnforced"]) && alltrue([for r in aws_s3_bucket_ownership_controls.logs.rule : r.object_ownership == "BucketOwnerEnforced"])
    error_message = "both buckets must disable ACLs with BucketOwnerEnforced"
  }

  assert {
    condition     = alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.console.rule : alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])]) && alltrue([for r in aws_s3_bucket_server_side_encryption_configuration.logs.rule : alltrue([for d in r.apply_server_side_encryption_by_default : d.sse_algorithm == "AES256"])])
    error_message = "both buckets must be encrypted with SSE-S3"
  }

  assert {
    condition     = anytrue([for r in aws_s3_bucket_lifecycle_configuration.logs.rule : alltrue([for e in r.expiration : e.days == 30])])
    error_message = "the access logs expire after 30 days (SPEC section 8)"
  }

  assert {
    condition     = aws_s3_bucket.console.force_destroy && aws_s3_bucket.logs.force_destroy
    error_message = "both buckets must be destroyable by make destroy with their objects"
  }
}

run "console_bucket_refuses_insecure_and_old_tls_requests" {
  command = plan

  module {
    source = "../../modules/web"
  }

  # The read statement names the distribution ARN, which is unknown in a plan (the same limit as
  # identity R50). It is reviewed in the plan comment; the TLS denies are plan-known and checked here.
  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.console_tls.json).Statement : s if s.Effect == "Deny" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"]) == 1
    error_message = "the console bucket must deny requests that are not TLS"
  }

  assert {
    condition     = length([for s in jsondecode(data.aws_iam_policy_document.console_tls.json).Statement : s if s.Effect == "Deny" && tostring(try(s.Condition.NumericLessThan["s3:TlsVersion"], "")) == "1.2"]) == 1
    error_message = "the console bucket must deny TLS versions older than 1.2"
  }

  assert {
    condition     = alltrue([for s in jsondecode(data.aws_iam_policy_document.console_tls.json).Statement : s.Effect == "Deny"])
    error_message = "the TLS document only denies: the read grant lives in the read statement, never here"
  }

  assert {
    condition     = aws_s3_bucket.console.bucket_regional_domain_name == "mfc-demo-console-vinsl.s3.eu-west-3.amazonaws.com"
    error_message = "the origin is the regional bucket domain, which OAC signs"
  }
}

run "logs_bucket_takes_only_the_console_server_access_logs" {
  command = plan

  module {
    source = "../../modules/web"
  }

  assert {
    condition     = aws_s3_bucket_logging.console.target_bucket == "mfc-demo-logs-vinsl" && aws_s3_bucket_logging.console.target_prefix == "s3/"
    error_message = "the console bucket logs to the logs bucket under s3/"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Sid == "AllowBucketAccessLogs" && s.Effect == "Allow"]) == 1
    error_message = "the log delivery statement AllowBucketAccessLogs must exist"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Effect == "Allow"]) == 1
    error_message = "the logs bucket policy grants nothing but the S3 log delivery"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : strcontains(jsonencode(s.Principal), "logging.s3.amazonaws.com") && strcontains(jsonencode(s.Condition), "123456789012") && strcontains(jsonencode(s.Condition), "arn:aws:s3:::mfc-demo-console-vinsl") if s.Sid == "AllowBucketAccessLogs"])
    error_message = "the S3 log delivery may write only for the console bucket of this account (confused deputy check)"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : strcontains(jsonencode(s.Condition), "arn:aws:s3:::mfc-demo-site-maps-vinsl") if s.Sid == "AllowBucketAccessLogs"])
    error_message = "the S3 log delivery may also write for the site-maps bucket of this account"
  }

  assert {
    condition     = alltrue([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s.Resource == "arn:aws:s3:::mfc-demo-logs-vinsl/s3/*" if s.Sid == "AllowBucketAccessLogs"])
    error_message = "the site-maps logs go under s3/site-maps/, inside the s3/ prefix that the log delivery statement grants"
  }
}

run "logs_bucket_refuses_insecure_and_old_tls_requests" {
  command = plan

  module {
    source = "../../modules/web"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Sid == "DenyInsecureTransport" && s.Effect == "Deny" && try(s.Condition.Bool["aws:SecureTransport"], "") == "false"]) == 1
    error_message = "the logs bucket must deny requests that are not TLS"
  }

  assert {
    condition     = length([for s in jsondecode(aws_s3_bucket_policy.logs.policy).Statement : s if s.Sid == "DenyOldTlsVersions" && s.Effect == "Deny" && tostring(try(s.Condition.NumericLessThan["s3:TlsVersion"], "")) == "1.2"]) == 1
    error_message = "the logs bucket must deny TLS versions older than 1.2"
  }
}

run "distribution_serves_the_build_over_https_with_spa_routing" {
  command = plan

  module {
    source = "../../modules/web"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.default_root_object == "index.html" && aws_cloudfront_distribution.this.price_class == "PriceClass_100"
    error_message = "the distribution serves index.html at the root and uses the cheapest price class"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.default_cache_behavior[0].viewer_protocol_policy == "redirect-to-https" && alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b.viewer_protocol_policy == "redirect-to-https"])
    error_message = "every behaviour redirects plain HTTP to HTTPS"
  }

  assert {
    condition     = toset(aws_cloudfront_distribution.this.default_cache_behavior[0].allowed_methods) == toset(["GET", "HEAD"]) && alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : toset(b.allowed_methods) == toset(["GET", "HEAD"])])
    error_message = "the console is read-only: GET and HEAD only"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.default_cache_behavior[0].cache_policy_id == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" && aws_cloudfront_distribution.this.ordered_cache_behavior[0].cache_policy_id == "658327ea-f89d-4fab-a63d-7e88639e58f6"
    error_message = "index.html and config.json are never cached (CachingDisabled), and the assets are (CachingOptimized)"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.ordered_cache_behavior[0].path_pattern == "/assets/*"
    error_message = "the hashed build assets are the only cached path"
  }

  assert {
    condition     = toset([for e in aws_cloudfront_distribution.this.custom_error_response : e.error_code]) == toset([403, 404]) && alltrue([for e in aws_cloudfront_distribution.this.custom_error_response : e.response_code == 200 && e.response_page_path == "/index.html" && e.error_caching_min_ttl == 0])
    error_message = "403 and 404 return index.html with 200 and are not cached, so the router decides"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.viewer_certificate[0].cloudfront_default_certificate && aws_cloudfront_distribution.this.restrictions[0].geo_restriction[0].restriction_type == "none"
    error_message = "the default certificate and no geo restriction are the documented choices of ADR 0046"
  }

  assert {
    condition     = aws_cloudfront_origin_access_control.console.origin_access_control_origin_type == "s3" && aws_cloudfront_origin_access_control.console.signing_behavior == "always" && aws_cloudfront_origin_access_control.console.signing_protocol == "sigv4"
    error_message = "the origin is signed with OAC, always, sigv4"
  }

  assert {
    condition     = aws_cloudfront_distribution.this.default_cache_behavior[0].response_headers_policy_id == "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b" && alltrue([for b in aws_cloudfront_distribution.this.ordered_cache_behavior : b.response_headers_policy_id == "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b"])
    error_message = "every behaviour carries the security headers policy"
  }
}

run "response_headers_carry_the_strict_csp_and_no_inline_code" {
  command = plan

  module {
    source = "../../modules/web"
  }

  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "frame-ancestors 'none'") && strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "default-src 'none'") && strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "object-src 'none'")
    error_message = "the CSP denies by default, forbids framing and objects"
  }

  assert {
    condition     = !strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-inline") && !strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "unsafe-eval")
    error_message = "the CSP must not allow inline scripts or styles, nor eval (SEC-WEB-1)"
  }

  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "connect-src 'self' https://*.execute-api.eu-west-3.amazonaws.com wss://*.execute-api.eu-west-3.amazonaws.com https://cognito-idp.eu-west-3.amazonaws.com https://cognito-identity.eu-west-3.amazonaws.com https://kinesisvideo.eu-west-3.amazonaws.com")
    error_message = "connect-src lists the API, WebSocket, Cognito and Kinesis Video hosts of the region only"
  }

  # The browser POSTs the presigned upload and GETs the preview of a map: both are connect-src requests
  # to the one bucket host, never to an S3 wildcard (ADR 0054).
  assert {
    condition     = strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "connect-src 'self' https://*.execute-api.eu-west-3.amazonaws.com wss://*.execute-api.eu-west-3.amazonaws.com https://cognito-idp.eu-west-3.amazonaws.com https://cognito-identity.eu-west-3.amazonaws.com https://kinesisvideo.eu-west-3.amazonaws.com https://*.kinesisvideo.eu-west-3.amazonaws.com wss://*.kinesisvideo.eu-west-3.amazonaws.com https://mfc-demo-site-maps-vinsl.s3.eu-west-3.amazonaws.com") && !strcontains(aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_security_policy[0].content_security_policy, "*.s3.")
    error_message = "connect-src allows the one site-maps bucket host of the region, and no S3 wildcard"
  }

  assert {
    condition     = aws_cloudfront_response_headers_policy.console.security_headers_config[0].strict_transport_security[0].access_control_max_age_sec == 63072000 && aws_cloudfront_response_headers_policy.console.security_headers_config[0].strict_transport_security[0].include_subdomains
    error_message = "HSTS lasts two years and covers the subdomains"
  }

  assert {
    condition     = aws_cloudfront_response_headers_policy.console.security_headers_config[0].frame_options[0].frame_option == "DENY" && aws_cloudfront_response_headers_policy.console.security_headers_config[0].referrer_policy[0].referrer_policy == "no-referrer" && aws_cloudfront_response_headers_policy.console.security_headers_config[0].content_type_options[0].override
    error_message = "frames are denied, the referrer is never sent and MIME sniffing is off"
  }

  assert {
    condition     = toset([for h in aws_cloudfront_response_headers_policy.console.custom_headers_config[0].items : h.header]) == toset(["Permissions-Policy", "Cross-Origin-Opener-Policy", "Cross-Origin-Resource-Policy"]) && alltrue([for h in aws_cloudfront_response_headers_policy.console.custom_headers_config[0].items : h.override])
    error_message = "the Permissions-Policy and the cross-origin headers are set on every response"
  }
}

run "outputs_expose_the_origin_bucket_and_distribution" {
  command = plan

  module {
    source = "../../modules/web"
  }

  assert {
    condition     = output.console_origin == "https://d111111abcdef8.cloudfront.net" && output.distribution_id == "E1ABCDEF2GHIJK" && output.bucket_name == "mfc-demo-console-vinsl" && output.logs_bucket_name == "mfc-demo-logs-vinsl"
    error_message = "the outputs expose the HTTPS origin, the distribution id, the console bucket name and the logs bucket name"
  }
}
