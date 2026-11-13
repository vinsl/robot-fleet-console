# Inputs of the queues module: the prefix of the queue names and the topic of the queue alarms.

variable "name_prefix" {
  type        = string
  description = "Prefix of every name of the demo stack, for example mfc-demo."
}

variable "alarm_topic_arn" {
  type        = string
  description = "ARN of the SNS topic that receives the dead-letter alarms, the alarm topic of the stack."
}
