# Inputs of the alarm-topic module. The alarm address is sensitive so that plans and logs mask it.

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "account_id" {
  type        = string
  description = "Twelve-digit AWS account id that owns the topic and its alarms."

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account id."
  }
}

variable "region" {
  type        = string
  description = "Region of the topic and of the CloudWatch alarms that publish to it."
}

variable "alarm_email" {
  type        = string
  description = "E-mail address that receives the alarm notifications. Sensitive: never printed."
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be a valid e-mail address."
  }
}
