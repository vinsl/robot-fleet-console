# Inputs of the audit-trail module: naming, the account and region that form the trail ARN, and
# the retention of the trail logs.

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "bucket_suffix" {
  type        = string
  description = "Suffix that makes the global S3 bucket name of the trail unique."
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account id that owns the trail and its bucket."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  type        = string
  description = "Home region of the trail. A multi-region trail still records from every region."
}

variable "log_retention_days" {
  type        = number
  description = "Days after which the current trail log objects expire."
  default     = 90

  validation {
    condition     = var.log_retention_days >= 30 && var.log_retention_days <= 365
    error_message = "log_retention_days must be between 30 and 365."
  }
}

variable "noncurrent_retention_days" {
  type        = number
  description = "Days after which the superseded versions of trail log objects expire."
  default     = 30

  validation {
    condition     = var.noncurrent_retention_days >= 1 && var.noncurrent_retention_days <= 90
    error_message = "noncurrent_retention_days must be between 1 and 90."
  }
}
