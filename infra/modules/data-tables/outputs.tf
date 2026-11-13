# Names and ARNs of the fleet and events tables, consumed by the robots function and its policy.

output "fleet_table_name" {
  type        = string
  description = "Name of the fleet table (registry of robots)."
  value       = aws_dynamodb_table.fleet.name
}

output "fleet_table_arn" {
  type        = string
  description = "ARN of the fleet table."
  value       = aws_dynamodb_table.fleet.arn
}

output "events_table_name" {
  type        = string
  description = "Name of the events table (audit trail and, from M5, robot events)."
  value       = aws_dynamodb_table.events.name
}

output "events_table_arn" {
  type        = string
  description = "ARN of the events table."
  value       = aws_dynamodb_table.events.arn
}

output "connections_table_name" {
  type        = string
  description = "Name of the connections table (WebSocket connections and single-use tokens)."
  value       = aws_dynamodb_table.connections.name
}

output "connections_table_arn" {
  type        = string
  description = "ARN of the connections table."
  value       = aws_dynamodb_table.connections.arn
}

output "connections_site_index_arn" {
  type        = string
  description = "ARN of the bySite index of the connections table, used by the fan-out queries."
  value       = "${aws_dynamodb_table.connections.arn}/index/bySite"
}

output "events_open_alerts_index_arn" {
  type        = string
  description = "ARN of the openAlerts index of the events table: the open alerts of a site and the resolved history (M8)."
  value       = "${aws_dynamodb_table.events.arn}/index/openAlerts"
}
