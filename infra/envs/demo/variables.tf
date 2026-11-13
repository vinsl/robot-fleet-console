# Inputs of the demo environment. Every variable has a default because CI runs plans without
# -var flags, and the alarm address is deliberately not a variable: it is read from SSM.

variable "region" {
  type        = string
  description = "AWS region of the demo stack. Limited to the two regions the demo may use (ADR 0006)."
  default     = "eu-west-3"

  validation {
    condition     = contains(["eu-west-3", "eu-west-1"], var.region)
    error_message = "region must be eu-west-3 or eu-west-1."
  }
}

variable "owner" {
  type        = string
  description = "Value of the owner tag applied to every demo resource."
  default     = "vincent"
}

variable "bucket_suffix" {
  type        = string
  description = "Suffix that makes the global S3 bucket names of the demo unique."
  default     = "vinsl"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$", var.bucket_suffix))
    error_message = "bucket_suffix must be 3 to 22 lowercase letters, digits or hyphens."
  }
}

variable "ws_allowed_origins" {
  type        = list(string)
  description = "Extra origins that may open a WebSocket when the browser sends an Origin header (R41), on top of the console origin, which the realtime module always adds from the web module. Exact matches only, never a wildcard."
  default     = ["http://localhost:5173"]

  validation {
    condition     = alltrue([for o in var.ws_allowed_origins : can(regex("^https?://[a-z0-9.:-]+$", o))])
    error_message = "every origin must be http or https with lowercase letters, digits, dots, colons or hyphens, and no wildcard."
  }
}

variable "telemetry_batch_window_seconds" {
  type        = number
  description = "Batching window of the telemetry event source mapping, in seconds. 1 keeps the invocation count low (docs/COSTS.md)."
  default     = 1

  validation {
    condition     = var.telemetry_batch_window_seconds >= 0 && var.telemetry_batch_window_seconds <= 5
    error_message = "telemetry_batch_window_seconds must be between 0 and 5."
  }
}

variable "enable_dev_origin" {
  type        = bool
  description = "Adds http://localhost:5173 to the API CORS allow-list so `make dev` can call the deployed API. Keep false outside development sessions."
  default     = false
}
