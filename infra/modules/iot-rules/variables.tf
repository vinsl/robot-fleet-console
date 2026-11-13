# Inputs of the iot-rules module: the naming and the account, the boundary of the rules role, the
# two SQS targets, and the ingest-events function that receives the events, the acks and the presence.

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account id that owns the rules."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  type        = string
  description = "Region of the topic rules."
}

variable "boundary_arn" {
  type        = string
  description = "ARN of the workload permissions boundary that the rules role must carry (ADR 0020)."
}

variable "role_path" {
  type        = string
  description = "IAM path of the rules role. Must be /mfc-demo/, the path the deploy role may create and pass."

  validation {
    condition     = var.role_path == "/mfc-demo/"
    error_message = "role_path must be /mfc-demo/."
  }
}

variable "telemetry_queue_url" {
  type        = string
  description = "URL of the telemetry queue that receives the telemetry rule."
}

variable "telemetry_queue_arn" {
  type        = string
  description = "ARN of the telemetry queue."
}

variable "errors_queue_url" {
  type        = string
  description = "URL of the queue that receives the actions that a rule could not perform."
}

variable "errors_queue_arn" {
  type        = string
  description = "ARN of the queue that receives the rule errors."
}

variable "ingest_events_function_arn" {
  type        = string
  description = "ARN of the ingest-events function that the events, acks and presence rules invoke."
}

variable "ingest_events_function_name" {
  type        = string
  description = "Name of the ingest-events function, used by the invoke permissions."
}

variable "alarm_topic_arn" {
  type        = string
  description = "ARN of the SNS topic that receives the ParseError alarms of the four rules (ADR 0023)."
}
