# Inputs of the web module: naming, the account and region that form the bucket policies and the
# CSP host names, and the suffix that keeps the global S3 bucket names unique (ADR 0046).

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."

  validation {
    condition     = can(regex("^mfc-[a-z0-9-]+$", var.name_prefix))
    error_message = "name_prefix must start with mfc- and use lowercase letters, digits and hyphens."
  }
}

variable "bucket_suffix" {
  type        = string
  description = "Suffix that makes the global S3 bucket names of the console and its logs unique. It is not the account id, so the bucket names do not expose it in URLs."
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account id that owns the buckets and the distribution. Used to scope the access log delivery."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  type        = string
  description = "AWS region of the console bucket and of the API and identity hosts that the CSP allows. CloudFront itself is global."

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "region must look like eu-west-3."
  }
}
