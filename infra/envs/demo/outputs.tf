# Names fixed by make smoke, which reads them from the Terraform outputs of this root.

output "trail_name" {
  type        = string
  description = "Name of the multi-region CloudTrail trail that make smoke checks."
  value       = module.audit_trail.trail_name
}

output "trail_arn" {
  type        = string
  description = "ARN of the multi-region CloudTrail trail."
  value       = module.audit_trail.trail_arn
}

output "trail_bucket_name" {
  type        = string
  description = "Name of the private bucket that receives the trail logs."
  value       = module.audit_trail.bucket_name
}

output "alarm_topic_arn" {
  type        = string
  description = "ARN of the SNS topic that receives the CloudWatch alarms, read by make smoke."
  value       = module.alarm_topic.topic_arn
}

output "fleet_table_name" {
  type        = string
  description = "Name of the fleet table (registry of robots)."
  value       = module.data_tables.fleet_table_name
}

output "events_table_name" {
  type        = string
  description = "Name of the events table (audit trail and robot events)."
  value       = module.data_tables.events_table_name
}

output "robots_function_name" {
  type        = string
  description = "Name of the robots function, invoked by the admin script with IAM."
  value       = module.robots_function.function_name
}

output "telemetry_queue_url" {
  type        = string
  description = "URL of the telemetry queue that the telemetry rule fills."
  value       = module.queues.telemetry_queue_url
}

output "iot_rule_names" {
  type        = list(string)
  description = "Names of the four IoT topic rules of the robot stack."
  value       = module.iot_rules.rule_names
}

output "iot_data_endpoint" {
  type        = string
  description = "Account-specific IoT data endpoint that robots and the robots function use."
  value       = data.aws_iot_endpoint.data.endpoint_address
}

output "iot_credentials_endpoint" {
  type        = string
  description = "Account-specific IoT credentials endpoint that the robots function uses for the role alias."
  value       = data.aws_iot_endpoint.credentials.endpoint_address
}

output "ws_url" {
  type        = string
  description = "WSS URL of the live console WebSocket, which the console connects to after ws-token."
  value       = module.websocket_api.ws_url
}

output "ws_management_endpoint" {
  type        = string
  description = "HTTPS management endpoint of the WebSocket stage. Not a secret: it is only usable with IAM."
  value       = module.websocket_api.management_endpoint
}

output "user_pool_id" {
  type        = string
  description = "ID of the Cognito user pool of the operators, read by the console runtime configuration."
  value       = module.identity.user_pool_id
}

output "user_pool_client_id" {
  type        = string
  description = "ID of the public app client of the console, read by the console runtime configuration."
  value       = module.identity.user_pool_client_id
}

output "user_pool_endpoint" {
  type        = string
  description = "Issuer URL of the user pool, which the HTTP API JWT authorizer validates the tokens against."
  value       = module.identity.user_pool_endpoint
}

output "identity_pool_id" {
  type        = string
  description = "ID of the identity pool that gives the signed-in console temporary AWS credentials."
  value       = module.identity.identity_pool_id
}

output "console_origin" {
  type        = string
  description = "HTTPS origin of the console, read by the publish script and the API CORS allow-list."
  value       = module.web.console_origin
}

output "console_bucket_name" {
  type        = string
  description = "Name of the private bucket that holds the console build, written by make publish-console."
  value       = module.web.bucket_name
}

output "console_distribution_id" {
  type        = string
  description = "ID of the CloudFront distribution of the console, invalidated by make publish-console."
  value       = module.web.distribution_id
}

output "site_maps_bucket_name" {
  type        = string
  description = "Name of the private bucket that holds the site maps, read by the simulator's map fetch script."
  value       = module.site_maps.bucket_name
}

output "api_endpoint" {
  type        = string
  description = "Default HTTPS endpoint of the console HTTP API, read by the console runtime configuration."
  value       = module.http_api.api_endpoint
}

output "region" {
  type        = string
  description = "AWS region of the demo stack, read by the console runtime configuration and the publish script."
  value       = var.region
}
