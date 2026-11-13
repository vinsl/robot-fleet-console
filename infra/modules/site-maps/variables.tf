# Inputs of the site-maps module: naming, the console origin allowed to upload and read the maps, and
# the logs bucket of the access logs (M7, SPEC section 8).

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
  description = "Suffix that makes the global S3 bucket name of the site maps unique. It is not the account id, so the name does not expose it."
}

variable "console_origin" {
  type        = string
  description = "HTTPS origin of the console. The only browser origin the bucket accepts in CORS, for the presigned POST and the preview GET."

  validation {
    condition     = can(regex("^https://[a-z0-9.-]{1,253}$", var.console_origin))
    error_message = "console_origin must be an https origin with lowercase letters, digits, dots or hyphens."
  }
}

variable "logs_bucket_name" {
  type        = string
  description = "Name of the bucket of the S3 server access logs, owned by the web module. The site maps log under s3/site-maps/ of it."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.logs_bucket_name))
    error_message = "logs_bucket_name must be a valid S3 bucket name."
  }
}
