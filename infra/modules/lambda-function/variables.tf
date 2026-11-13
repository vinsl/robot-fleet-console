# Inputs of the lambda-function module: one function with its own role, boundary, policy and log
# group. The retry and event-age settings are explicit so that every function states its contract.

variable "name" {
  type        = string
  description = "Name of the function, of its role and of its log group. Must start with mfc-demo-."

  validation {
    condition     = can(regex("^mfc-demo-[a-z0-9-]{1,40}$", var.name))
    error_message = "name must match mfc-demo-[a-z0-9-]{1,40}."
  }
}

variable "description" {
  type        = string
  description = "Human-readable purpose of the function, shown in the Lambda console."
}

variable "source_dir" {
  type        = string
  description = "Directory of the built bundle (index.mjs and its source map) that is packed into the deployment archive."
}

variable "boundary_arn" {
  type        = string
  description = "ARN of the workload permissions boundary that the function role must carry (ADR 0020)."
}

variable "role_path" {
  type        = string
  description = "IAM path of the function role. Must be /mfc-demo/, the path the deploy role may pass."

  validation {
    condition     = var.role_path == "/mfc-demo/"
    error_message = "role_path must be /mfc-demo/."
  }
}

variable "policy_json" {
  type        = string
  description = "Business permissions of the function, as a JSON policy document built with jsonencode(). Null for a function that needs no business permission: only the logging and tracing policy is then attached."
  default     = null
}

variable "environment" {
  type        = map(string)
  description = "Environment variables of the function. Never a secret: the function reads no secret from its environment (THREAT_MODEL R2)."
  default     = {}
}

variable "timeout" {
  type        = number
  description = "Timeout of the function in seconds. Set explicitly for every function (engineering standards)."

  validation {
    condition     = var.timeout >= 1 && var.timeout <= 60
    error_message = "timeout must be between 1 and 60 seconds."
  }
}

variable "memory_size" {
  type        = number
  description = "Memory of the function in MB."
  default     = 256
}

variable "maximum_retry_attempts" {
  type        = number
  description = "Retries of an asynchronous invocation. Synchronous callers use 0 so that a retry cannot repeat an effect."

  validation {
    condition     = var.maximum_retry_attempts >= 0 && var.maximum_retry_attempts <= 2
    error_message = "maximum_retry_attempts must be between 0 and 2."
  }
}

variable "maximum_event_age_in_seconds" {
  type        = number
  description = "Maximum age of an asynchronous event before Lambda drops it."

  validation {
    condition     = var.maximum_event_age_in_seconds >= 60 && var.maximum_event_age_in_seconds <= 21600
    error_message = "maximum_event_age_in_seconds must be between 60 and 21600."
  }
}

variable "dead_letter_queue_arn" {
  type        = string
  description = "ARN of the SQS queue that receives failed asynchronous events. Null for a synchronous function."
  default     = null
}

variable "log_retention_days" {
  type        = number
  description = "Days that the function log group keeps its events (NFR-OBS-1)."
  default     = 7
}

variable "alarm_topic_arn" {
  type        = string
  description = "ARN of the SNS topic that receives the Errors and Throttles alarms of the function (ADR 0023). Used only when enable_alarms is true."
  default     = null
}

variable "enable_alarms" {
  type        = bool
  description = "Creates the Errors and Throttles alarms. A plain flag, not a test of the topic ARN: after a destroy and re-apply the ARN is unknown at plan time and a count that depends on it would fail. Requires alarm_topic_arn."
  default     = false

  validation {
    condition     = !var.enable_alarms || var.alarm_topic_arn != null
    error_message = "enable_alarms needs alarm_topic_arn."
  }
}
