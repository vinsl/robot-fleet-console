# Identifiers of the API. The management endpoint and the execution ARN feed the IAM policies and
# the environment of the functions that push to connections; the WebSocket URL feeds ws-token.

output "api_id" {
  type        = string
  description = "ID of the WebSocket API."
  value       = aws_apigatewayv2_api.this.id
}

output "execution_arn" {
  type        = string
  description = "Execution ARN of the API. The @connections resources of the IAM policies are built from it."
  value       = aws_apigatewayv2_api.this.execution_arn
}

output "stage_arn" {
  type        = string
  description = "ARN of the stage. The @connections resources of the IAM policies are built from it: <stage_arn>/POST/@connections/*."
  value       = "${aws_apigatewayv2_api.this.execution_arn}/${var.stage_name}"
}

output "management_endpoint" {
  type        = string
  description = "HTTPS endpoint of the stage for the management API (PostToConnection, DeleteConnection)."
  value       = local.management_endpoint
}

output "ws_url" {
  type        = string
  description = "WSS URL of the stage that the console connects to."
  value       = "wss://${aws_apigatewayv2_api.this.id}.execute-api.${var.region}.amazonaws.com/${var.stage_name}"
}
