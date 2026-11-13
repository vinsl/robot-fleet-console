# Inputs of the websocket-api module: the API, its stage, the three routes that call Lambda
# functions, and the throttles of the stage (SPEC section 8, design section 6.2).

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "region" {
  type        = string
  description = "AWS region of the API. Used to build the Lambda integration URIs and the endpoints."
}

variable "stage_name" {
  type        = string
  description = "Name of the stage. It appears in the management endpoint, so it stays lowercase and simple."
  default     = "live"

  validation {
    condition     = can(regex("^[a-z]{1,16}$", var.stage_name))
    error_message = "stage_name must be 1 to 16 lowercase letters."
  }
}

variable "routes" {
  type = object({
    connect    = object({ function_arn = string, function_name = string })
    disconnect = object({ function_arn = string, function_name = string })
    default    = object({ function_arn = string, function_name = string })
  })
  description = "The Lambda function behind each route: $connect (token check), $disconnect (cleanup) and $default (client messages)."
}

variable "throttle_rate" {
  type        = number
  description = "Steady-state requests per second allowed on the stage for the messages of established connections."
  default     = 50
}

variable "throttle_burst" {
  type        = number
  description = "Burst of requests allowed on the stage for the messages of established connections."
  default     = 100
}

variable "connect_rate" {
  type        = number
  description = "Steady-state connection attempts per second on $connect (R40)."
  default     = 10
}

variable "connect_burst" {
  type        = number
  description = "Burst of connection attempts on $connect (R40)."
  default     = 20
}
