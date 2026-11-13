# Inputs of the http-api module: the HTTP API of the console, its JWT authorizer on the operator user
# pool, the CORS allow-list, the routes with their functions and throttles, and the alarm topic
# (M6, ADR 0047). Every route states its function and its throttles explicitly.

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "console_origin" {
  type        = string
  description = "HTTPS origin of the console (the CloudFront distribution). The only browser origin allowed by default."

  validation {
    condition     = can(regex("^https://[a-z0-9.-]{1,253}$", var.console_origin))
    error_message = "console_origin must be an https origin with lowercase letters, digits, dots or hyphens."
  }
}

variable "enable_dev_origin" {
  type        = bool
  description = "Adds the Vite dev server origin to the CORS allow-list, for make dev against the deployed API. Off in the demo stack by default."
  default     = false
}

variable "user_pool_endpoint" {
  type        = string
  description = "Issuer URL of the operator user pool, https://cognito-idp.<region>.amazonaws.com/<pool id>. The JWT authorizer validates the tokens against it."

  validation {
    condition     = can(regex("^https://cognito-idp\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9-]+_[A-Za-z0-9]+$", var.user_pool_endpoint))
    error_message = "user_pool_endpoint must be the issuer URL of a Cognito user pool."
  }
}

variable "user_pool_client_id" {
  type        = string
  description = "ID of the public app client of the console. The JWT authorizer checks the client_id claim of the access tokens against it."
}

variable "alarm_topic_arn" {
  type        = string
  description = "ARN of the SNS topic that receives the 5xx alarm of the API (ADR 0023). The Errors and Throttles alarms of each function live in the lambda-function module."
}

variable "routes" {
  type = map(object({
    method         = string
    path           = string
    function_arn   = string
    function_name  = string
    authorized     = bool
    throttle_rate  = optional(number)
    throttle_burst = optional(number)
    # Integration timeout. Routes keep the 5-second default unless a route waits for a longer function.
    timeout_milliseconds = optional(number)
  }))
  description = "Routes of the API, keyed by a short name. Each route calls one Lambda function. Throttles and the integration timeout are optional and set per route; the others take the defaults (stage throttles, 5-second timeout)."

  validation {
    condition     = alltrue([for r in values(var.routes) : contains(["GET", "POST", "PUT", "PATCH", "DELETE"], r.method)])
    error_message = "every route method must be GET, POST, PUT, PATCH or DELETE."
  }

  validation {
    # Each segment is a literal of lowercase letters, digits and hyphens, or a {Name} path parameter in
    # camel case (for example {siteId}). Anything else, such as an uppercase literal, is refused.
    condition     = alltrue([for r in values(var.routes) : length(r.path) <= 64 && can(regex("^(/([a-z0-9-]+|\\{[A-Za-z][A-Za-z0-9]{0,31}\\})){1,8}$", r.path))])
    error_message = "every route path must have at most 8 segments and 64 characters, each a lowercase literal or a {Name} path parameter."
  }

  validation {
    condition     = alltrue([for r in values(var.routes) : (r.throttle_rate == null) == (r.throttle_burst == null)])
    error_message = "a route sets both throttle_rate and throttle_burst, or neither."
  }

  validation {
    # API Gateway refuses an integration timeout above 30 seconds; the default applies when the route sets none.
    condition     = alltrue([for r in values(var.routes) : coalesce(r.timeout_milliseconds, 5000) >= 1 && coalesce(r.timeout_milliseconds, 5000) <= 30000])
    error_message = "every route timeout_milliseconds must be between 1 and 30000."
  }
}

variable "default_throttle_rate" {
  type        = number
  description = "Steady-state requests per second allowed on the stage for a route without its own throttle."
  default     = 25
}

variable "default_throttle_burst" {
  type        = number
  description = "Burst of requests allowed on the stage for a route without its own throttle."
  default     = 50
}

variable "log_retention_days" {
  type        = number
  description = "Days that the access log group keeps its events (NFR-OBS-1, SPEC section 8)."
  default     = 30
}
