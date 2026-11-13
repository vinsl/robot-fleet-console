# Inputs of the robot-iot module: the naming prefix, the account and region that form the ARNs of
# the IoT resources, and the workload boundary and path that every role of the demo must carry.

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account id that owns the IoT resources."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  type        = string
  description = "Region of the IoT resources and of the video channels they authorise."
}

variable "boundary_arn" {
  type        = string
  description = "ARN of the workload permissions boundary that every role of this module must carry (ADR 0020)."
}

variable "role_path" {
  type        = string
  description = "IAM path of the roles of this module. Must be /mfc-demo/, the path the deploy role may create and pass."

  validation {
    condition     = var.role_path == "/mfc-demo/"
    error_message = "role_path must be /mfc-demo/."
  }
}
