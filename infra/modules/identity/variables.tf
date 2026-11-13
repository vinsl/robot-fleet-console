# Inputs of the identity module: naming, the account and region that form the Kinesis Video
# channel ARNs, and the boundary and path that every console role carries (ADR 0020, ADR 0021).

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "region" {
  type        = string
  description = "AWS region of the user pool, the identity pool and the robot video channels."
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account id that owns the pools and the console roles."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "boundary_arn" {
  type        = string
  description = "ARN of the workload permission boundary that every console role carries."
}

variable "role_path" {
  type        = string
  description = "IAM path of the console roles. The deploy role may create roles under this path only."

  validation {
    condition     = can(regex("^/[a-z0-9-]+/$", var.role_path))
    error_message = "role_path must look like /mfc-demo/."
  }
}
