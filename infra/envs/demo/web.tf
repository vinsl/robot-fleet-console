# Delivery of the console (M6, ADR 0046): the private bucket of the build, the CloudFront
# distribution in front of it with the strict CSP, and the bucket of the access logs. The bucket
# suffix keeps the global bucket names unique, as it does for the audit trail.

module "web" {
  source = "../../modules/web"

  name_prefix   = local.name_prefix
  bucket_suffix = var.bucket_suffix
  account_id    = local.account_id
  region        = var.region
}
