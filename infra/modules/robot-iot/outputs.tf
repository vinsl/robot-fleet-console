# Identifiers of the robot identity, exposed to the root and to the robots function environment.

output "robot_policy_name" {
  type        = string
  description = "Name of the single IoT policy that every robot certificate carries."
  value       = aws_iot_policy.robot.name
}

output "role_alias_name" {
  type        = string
  description = "Name of the IoT role alias that robots use for video credentials (ROLE_ALIAS_NAME)."
  value       = aws_iot_role_alias.kvs_master.alias
}

output "role_alias_arn" {
  type        = string
  description = "ARN of the IoT role alias."
  value       = local.role_alias_arn
}

output "kvs_master_role_arn" {
  type        = string
  description = "ARN of the video master role assumed through the role alias."
  value       = aws_iam_role.kvs_master.arn
}
